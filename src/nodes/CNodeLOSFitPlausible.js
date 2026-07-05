// Global "plausible object" fit to LOS rays — AUTONOMOUS range finder.
//
// Searches for the START RANGE whose smoothest LOS-riding trajectory requires
// the least maneuvering, then returns the full-quality least-maneuvering path
// there. Unlike the Const Air Spd traverse (which sits at the "Tgt Start
// Dist" you set), this finds its own range. Two-stage: when the sensor's own
// motion makes the smoothness-vs-range valley decisive (an orbiting or
// turning sensor), geometry alone picks the range; only for narrow-baseline
// sightlines like Gimbal (where range is unobservable from geometry) does the
// soft airspeed target from the "Target Speed" slider break the tie and give
// the plausibility-vs-range curve a real minimum. See src/TraverseAnalysis.js
// (fitPlausibleBestRange).

import {CNodeTrack} from "./CNodeTrack";
import {fitPlausibleBestRange, KNOTS_TO_MS, METERS_PER_NM} from "../TraverseAnalysis";
import {buildAnalysisDataset, unpackTrackToECEF} from "../TraverseAnalysisData";
import {guiMenus, NodeMan} from "../Globals";
import {t} from "../i18n";

export class CNodeLOSFitPlausible extends CNodeTrack {
    constructor(v) {
        super(v);
        this.requireInputs(["LOS"]);
        // startDist is only a wind-anchor hint now; the fit finds its own range
        this.optionalInputs(["startDist", "speed", "wind"]);
        this.array = [];
        this._dirty = true;
        this.foundRange = null;
        this.guiFolder = null;
        this.guiDisplay = {};
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

        // wind local frame is anchored roughly mid-envelope; not range-critical
        const anchorDist = this.in.startDist ? this.in.startDist.v0 : 20 * METERS_PER_NM;
        const {dataset, originLat, originLon} =
            buildAnalysisDataset(this.in.LOS, this.in.wind ?? null, anchorDist);

        const vTarget = this.in.speed ? this.in.speed.v0 : 300 * KNOTS_TO_MS;
        // Respect the "Analysis Min/Max Dist" limits (if the user pinned a rough
        // range) so this matches what the traverse analysis previewed.
        const opts = {vTarget, vSigma: 60 * KNOTS_TO_MS};
        const minNode = NodeMan.get("analysisMinDist", false);
        const maxNode = NodeMan.get("analysisMaxDist", false);
        const userMin = minNode ? minNode.v0 : 0;
        const userMax = maxNode ? maxNode.v0 : 1000 * METERS_PER_NM;
        if (userMin > 1 || userMax < 999 * METERS_PER_NM) {
            opts.rangeMin = Math.max(0.1 * METERS_PER_NM, userMin);
            opts.rangeMax = Math.max(opts.rangeMin * 1.2, userMax);
        }
        const result = fitPlausibleBestRange(dataset, opts);

        this.foundRange = result.startDist;
        this.array = unpackTrackToECEF(result.track, this.frames, originLat, originLon);
        this.updateGUI(result, vTarget);
    }

    updateGUI(result, vTargetMs) {
        if (!guiMenus.traverse) return;
        if (this.guiFolder) { this.guiFolder.destroy(); this.guiFolder = null; }
        this.guiFolder = guiMenus.traverse.addFolder(
            t("losFitPlausible.folder", {defaultValue: "Plausible Fit Results"})).close();
        this.guiDisplay = {};
        // string rows (avoid lil-gui NumberController step requirement)
        this.guiDisplay._range = (result.startDist / METERS_PER_NM).toFixed(1) + " NM";
        this.guiDisplay._speed = result.usedSpeedTarget === false
            ? "not needed (geometry)"
            : (vTargetMs / KNOTS_TO_MS).toFixed(0) + " kt";
        this.guiDisplay._score = result.score.toFixed(3);
        this.guiFolder.add(this.guiDisplay, "_range")
            .name(t("losFitPlausible.range.label", {defaultValue: "Found Range"})).disable();
        this.guiFolder.add(this.guiDisplay, "_speed")
            .name(t("losFitPlausible.speed.label", {defaultValue: "Speed Target"})).disable();
        this.guiFolder.add(this.guiDisplay, "_score")
            .name(t("losFitPlausible.score.label", {defaultValue: "Plausibility (lower=better)"})).disable();
    }

    getValueFrame(f) {
        if (this._dirty) this._doCompute();
        return this.array[Math.floor(f)];
    }

    dispose() {
        if (this.guiFolder) { this.guiFolder.destroy(); this.guiFolder = null; }
        super.dispose();
    }
}
